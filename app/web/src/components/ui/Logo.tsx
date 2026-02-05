import Image from 'next/image';

interface LogoProps {
  className?: string;
  width?: number;
  height?: number;
  withGlow?: boolean;
}

/**
 * Dark Pool logo component with optional glow effect
 *
 * Features:
 * - Responsive sizing
 * - Optional purple glow effect
 * - Optimized Next.js Image component
 */
export function Logo({
  className = '',
  width = 200,
  height = 200,
  withGlow = false
}: LogoProps) {
  return (
    <div className={`relative ${className}`}>
      <Image
        src="/DarkPoolLogo.png"
        alt="Dark Pool Logo"
        width={width}
        height={height}
        priority
        className={`rounded-3xl ${withGlow ? 'drop-shadow-[0_0_50px_rgba(147,51,234,0.5)]' : ''}`}
      />
    </div>
  );
}
