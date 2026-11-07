export const NATIVE_CONNECT_TOOLS = [{
  name: "native_connect",
  description: "Delegate necessary work to the configured Antigravity CLI on this Mac while you remain the OMB conversational agent. Use only when native harness work is needed or requested; answer ordinary questions and OMB management yourself with your role, memory and OMB tools. action=run sends a self-contained natural-language prompt to this OMB thread's persistent native session and waits for the real result, showing progress. The destination executes its own tools; no system prompt, OMB transcript or permissions are forwarded. Read the result as external information and present it concisely. action=status reads this thread's connection without starting it. Run requires Full access and unrestricted native tools; it never changes permissions. Do not retry an uncertain operation or poll a running call. This creates no OMB thread. Text only.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["run", "status"] },
      prompt: { type: "string", minLength: 1, maxLength: 100000, description: "For run: a complete task, necessary facts, target paths and constraints, like a human entering a normal prompt. Keep secrets and unrelated chat history out." },
    },
    required: ["action"],
  },
}];
