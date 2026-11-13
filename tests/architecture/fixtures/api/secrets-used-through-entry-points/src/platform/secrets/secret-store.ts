export interface SecretStore {
  put(value: string): Promise<string>;
}

export const SECRET_STORE = Symbol('SECRET_STORE');
