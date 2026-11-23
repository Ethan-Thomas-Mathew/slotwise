import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';

it('renders', () => {
  render(<p>hello</p>);
  expect(screen.getByText('hello')).toBeInTheDocument();
});
