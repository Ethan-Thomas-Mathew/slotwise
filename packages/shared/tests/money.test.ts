import { expect, it } from 'vitest';
import { formatPaise } from '../src/money';

it('formats paise as rupees', () => {
  expect(formatPaise(49900)).toBe('₹499.00');
});
