// Public entry point: the port only, so importing it never reaches the adapter or the database.
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
