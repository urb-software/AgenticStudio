// Public entry point of the secrets capability: the port only, so importing it never reaches
// the adapter or the database client. A business module injects SECRET_STORE from here; its
// {module}.module.ts imports SecretsModule (secrets.module.ts) for the wiring.
export {
  SECRET_STORE,
  SecretDecryptionFailedError,
  SecretNotFoundError,
  type SecretOwner,
  type SecretReference,
  type SecretStore,
  SecretStoreError,
  SecretStoreUnavailableError,
} from './secret-store.js';
