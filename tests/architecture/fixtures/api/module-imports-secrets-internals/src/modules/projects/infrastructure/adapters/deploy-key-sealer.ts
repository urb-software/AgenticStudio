import { seal } from '../../../../platform/secrets/aes-256-gcm.js';

// Forbidden: encrypting outside platform/secrets instead of using the SecretStore port.
export function sealDeployKey(key: string, deployKey: string): string {
  return seal(key, deployKey);
}
