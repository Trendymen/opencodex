import { parseAuthorizationScheme } from "../lib/authorization-scheme";
import { resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "../server/auth-cors";
import type { OcxConfig } from "../types";

export function resolveLoopbackSidecarBearer(
  headers: Headers,
  config: OcxConfig,
  admission: DataPlaneAdmission | null,
): DataPlaneAdmission | null {
  if (admission?.source !== "loopback" || headers.get("x-opencodex-api-key")?.trim()) return admission;
  const authorization = parseAuthorizationScheme(headers.get("authorization"));
  if (authorization.kind !== "bearer") return admission;
  return resolveDataPlaneAdmissionSecret(authorization.token, config, "bearer") ?? admission;
}
