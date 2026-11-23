import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Field, StatusBadge } from '../src/components/ui';

describe('Field', () => {
  it('links the label and error message to the input for screen readers', async () => {
    render(<Field label="Email" error="Enter a valid email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email');
    await userEvent.type(input, 'a@b.c');
    expect(input).toHaveValue('a@b.c');
  });
});

describe('StatusBadge', () => {
  it('uses plain words, not database codes', () => {
    render(<StatusBadge status="HELD" />);
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument();
  });
});
