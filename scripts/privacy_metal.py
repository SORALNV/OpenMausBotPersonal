"""Metal MoE projections for the pinned OPF bf16 checkpoint; FP32 accumulation."""
from types import MethodType
import torch
import torch.nn.functional as F
from opf._model.model import swiglu


SOURCE = r"""
#include <metal_stdlib>
using namespace metal;

kernel void expert_linear(
    device const float* x,
    device const ushort* weights,
    device const ushort* bias,
    device const long* experts,
    device const long* order,
    device float* output,
    constant long& input_dim,
    constant long& output_dim,
    constant long& experts_per_token,
    constant long& shared_input,
    uint gid [[thread_position_in_grid]]) {
    ulong pair = order[gid / output_dim];
    ulong col = gid % output_dim;
    ulong expert = experts[pair];
    ulong row = shared_input ? pair / experts_per_token : pair;
    ulong x_offset = row * input_dim;
    ulong w_offset = expert * input_dim * output_dim + col;
    float4 sums = 0.0f;
    uint k = 0;
    for (; k + 3 < input_dim; k += 4) {
        float4 values = float4(x[x_offset + k], x[x_offset + k + 1], x[x_offset + k + 2], x[x_offset + k + 3]);
        float4 w = float4(
            as_type<float>(uint(weights[w_offset + k * output_dim]) << 16),
            as_type<float>(uint(weights[w_offset + (k + 1) * output_dim]) << 16),
            as_type<float>(uint(weights[w_offset + (k + 2) * output_dim]) << 16),
            as_type<float>(uint(weights[w_offset + (k + 3) * output_dim]) << 16));
        sums = fma(values, w, sums);
    }
    float sum = (sums.x + sums.y) + (sums.z + sums.w);
    for (; k < input_dim; ++k) {
        float w = as_type<float>(uint(weights[w_offset + k * output_dim]) << 16);
        sum = fma(x[x_offset + k], w, sum);
    }
    float b = as_type<float>(uint(bias[expert * output_dim + col]) << 16);
    output[pair * output_dim + col] = sum + b;
}

"""


def install_metal_moe(model):
    library = torch.mps.compile_shader(SOURCE)

    def project(x, weights, bias, indices, order, shared_input):
        if x.dtype != torch.float32 or not x.is_contiguous():
            raise ValueError("Metal projection requires contiguous FP32 input")
        output = torch.empty((*indices.shape, weights.shape[-1]), device=x.device, dtype=torch.float32)
        library.expert_linear(x, weights, bias, indices, order, output,
                              weights.shape[1], weights.shape[2], indices.shape[1], int(shared_input),
                              threads=output.numel())
        return output

    def forward(self, x):
        if x.dim() != 3 or x.shape[-1] != self.mlp1_weight.shape[1]:
            raise ValueError("Unsupported Metal input shape")
        batch_shape = x.shape[:-1]
        t = self.norm(x).reshape(-1, x.shape[-1])
        g = F.linear(t.float(), self.gate.weight.float(), self.gate.bias.float())
        experts = torch.topk(g, k=self.experts_per_token, dim=-1, sorted=True)
        expert_weights = F.softmax(experts.values, dim=1) / self.experts_per_token
        order = torch.argsort(experts.indices.reshape(-1))
        h = project(t.float().contiguous(), self.mlp1_weight, self.mlp1_bias, experts.indices, order, True)
        h = swiglu(h, limit=self.swiglu_limit, packed=self.packed_geglu)
        out = project(h.contiguous(), self.mlp2_weight, self.mlp2_bias, experts.indices, order, False)
        out = torch.einsum("bec,be->bc", out, expert_weights) * self.experts_per_token
        return x + out.to(x.dtype).reshape(*batch_shape, -1)

    for block in model.block:
        mlp = block.mlp
        for parameter in (mlp.mlp1_weight, mlp.mlp1_bias, mlp.mlp2_weight, mlp.mlp2_bias):
            if parameter.device.type != "mps" or parameter.dtype != torch.bfloat16 or not parameter.is_contiguous():
                raise ValueError("Unsupported Metal checkpoint layout")
        if mlp.world_size != 1:
            raise ValueError("Distributed Metal inference unsupported")
        if (mlp.mlp1_weight.shape != (mlp.num_experts, mlp.norm.num_features, mlp.mlp2_weight.shape[1] * 2)
                or mlp.mlp2_weight.shape != (mlp.num_experts, mlp.mlp2_weight.shape[1], mlp.norm.num_features)
                or mlp.mlp1_bias.shape != (mlp.num_experts, mlp.mlp1_weight.shape[2])
                or mlp.mlp2_bias.shape != (mlp.num_experts, mlp.norm.num_features)):
            raise ValueError("Unsupported Metal expert dimensions")
        mlp.forward = MethodType(forward, mlp)
