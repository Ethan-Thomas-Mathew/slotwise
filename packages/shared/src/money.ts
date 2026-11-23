/** Money is always stored as whole paise (integers). 1 rupee = 100 paise. */
export function formatPaise(paise: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(paise / 100);
}
