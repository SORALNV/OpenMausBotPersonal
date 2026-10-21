export const PRIVACY_TOOL_OPTION = "_openmausbot_local_privacy";

export function privacyToolCatalog(result: any): unknown {
  if (!result || !Array.isArray(result.tools)) throw new Error("Invalid tool catalog");
  return { ...result, tools: result.tools.map((tool: any) => {
    const schema = tool.inputSchema;
    if (Object.hasOwn(schema?.properties ?? {}, PRIVACY_TOOL_OPTION)) throw new Error("Reserved privacy option collision");
    if (!schema || schema.type !== "object") return tool;
    return { ...tool, description: `${tool.description ?? ""}\nSupports local masked retrieval using ${PRIVACY_TOOL_OPTION}=true.`, inputSchema: { ...schema, properties: { ...schema.properties,
      [PRIVACY_TOOL_OPTION]: { type: "boolean", description: "Set true when the user requests private/masked retrieval. The harness runs OpenAI privacy-filter locally on this tool's result BEFORE returning it to the AI. Failure blocks the result. Registered literal replacements also apply. No restoration or external send is performed." },
    } } };
  }) };
}

export function privacyToolRequest(frame: any): { frame: any; model: boolean } {
  const args = frame.params?.arguments;
  if (!args || !Object.hasOwn(args, PRIVACY_TOOL_OPTION)) return { frame, model: false };
  if (typeof args[PRIVACY_TOOL_OPTION] !== "boolean") throw new Error("Invalid local privacy option");
  const { [PRIVACY_TOOL_OPTION]: model, ...rest } = args;
  return { frame: { ...frame, params: { ...frame.params, arguments: rest } }, model };
}
