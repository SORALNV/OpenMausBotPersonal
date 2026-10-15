export function privacyPorts(env) {
  const port = (value, fallback) => {
    const text = value ?? String(fallback);
    if (!/^[1-9]\d{3,4}$/.test(text)) throw new Error("Privacy development port is invalid");
    const number = Number(text);
    if (number < 1024 || number > 65535 || [8799, 8800, 5199].includes(number)) throw new Error("Production or invalid ports are forbidden");
    return String(number);
  };
  const ports = {
    OMB_PORT: port(env.OMB_PRIVACY_PORT, 8899),
    OMB_UI_PORT: port(env.OMB_PRIVACY_UI_PORT, 5299),
    OMB_WEBHOOK_PORT: port(env.OMB_PRIVACY_WEBHOOK_PORT, 8900),
  };
  if (new Set(Object.values(ports)).size !== 3) throw new Error("Privacy development ports must be distinct");
  return ports;
}
