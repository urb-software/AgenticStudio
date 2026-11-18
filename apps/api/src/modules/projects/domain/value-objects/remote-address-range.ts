/** `blocked` addresses are never connected to, `private` ones only when the opt-in allows, the rest are `public`. */
export type RemoteAddressRange = 'public' | 'private' | 'blocked';
