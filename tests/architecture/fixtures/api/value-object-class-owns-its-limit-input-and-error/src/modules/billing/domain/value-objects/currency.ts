export const CURRENCIES = ['eur', 'usd'] as const;
export type Currency = (typeof CURRENCIES)[number];
