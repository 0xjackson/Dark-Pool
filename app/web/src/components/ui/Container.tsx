import { ReactNode } from 'react';

interface ContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * Centered layout container with z-index layering
 *
 * Provides:
 * - Centered content layout
 * - Proper z-index stacking above animations
 * - Responsive padding
 */
export function Container({ children, className = '' }: ContainerProps) {
  return (
    <div className={`relative z-10 min-h-screen flex items-center justify-center p-4 ${className}`}>
      <div className="w-full max-w-md">
        {children}
      </div>
    </div>
  );
}
