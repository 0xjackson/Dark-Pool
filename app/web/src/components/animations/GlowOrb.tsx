'use client';

import { motion } from 'framer-motion';

interface GlowOrbProps {
  delay?: number;
  duration?: number;
  size?: number;
  color?: string;
  initialX?: string;
  initialY?: string;
}

/**
 * Floating purple glow orb with smooth animation
 *
 * Features:
 * - Bezier curve path animations
 * - Customizable size, color, duration
 * - GPU-accelerated transforms
 * - Blur effect for dreamy glow
 */
export function GlowOrb({
  delay = 0,
  duration = 40,
  size = 300,
  color = 'rgba(147, 51, 234, 0.3)',
  initialX = '0%',
  initialY = '0%',
}: GlowOrbProps) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle, ${color}, transparent 70%)`,
        filter: 'blur(40px)',
        left: initialX,
        top: initialY,
      }}
      animate={{
        x: [0, 100, -50, 80, 0],
        y: [0, -80, 60, -40, 0],
        scale: [1, 1.2, 0.8, 1.1, 1],
        opacity: [0.3, 0.5, 0.4, 0.6, 0.3],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    />
  );
}
