import os
os.environ["OPF_MOE_TRITON"] = "0"
import unittest
from types import SimpleNamespace
import torch
from opf._model.model import MLPBlock, ModelConfig
from privacy_metal import install_metal_moe


@unittest.skipUnless(torch.backends.mps.is_available(), "Requires Apple GPU")
class MetalProjectionTest(unittest.TestCase):
    def test_fp32_computation_matches_native_moe(self):
        torch.manual_seed(1729)
        for packed, scale, width in [(False, 0.05, 16), (False, 0.5, 13), (True, 0.5, 16)]:
            with self.subTest(packed=packed, scale=scale, width=width):
                self.compare(packed, scale, width)

    def compare(self, packed, scale, width):
        config = ModelConfig(hidden_size=width, intermediate_size=width+8, num_experts=8, experts_per_token=4, packed_geglu=packed)
        mlp = MLPBlock(config, device=torch.device("mps"))
        for name, parameter in mlp.named_parameters():
            with torch.no_grad():
                value = torch.ones(parameter.shape) if name == "norm.scale" else torch.randn(parameter.shape) * scale
                parameter.copy_(value.to("mps"))
        reference = mlp.forward
        install_metal_moe(SimpleNamespace(block=[SimpleNamespace(mlp=mlp)]))
        for shape in [(1, 1, width), (1, 7, width), (1, 64, width), (1, 65, width), (2, 33, width)]:
            x = torch.randn(shape, device="cpu").to("mps")
            with torch.inference_mode():
                expected = reference(x)
                actual = mlp(x)
            torch.testing.assert_close(actual.cpu(), expected.cpu(), rtol=2e-5, atol=2e-5)


if __name__ == "__main__":
    unittest.main()
