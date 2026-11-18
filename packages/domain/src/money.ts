/**
 * Money is always an integer number of minor units (e.g. cents). Values are kept
 * within Number.MAX_SAFE_INTEGER so arithmetic is exact; floats are never valid money.
 */
export type MinorUnits = number;

export const isValidAmount = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export const isValidBalance = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
