/** A newly generated Deploy key. `privateKey` goes to the secret store only. */
export interface GeneratedDeployKey {
  privateKey: string;
  publicKey: string;
}
