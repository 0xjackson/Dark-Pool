'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';

/**
 * Animated liquid pool background with SVG blobs
 *
 * Features:
 * - Multiple layers of animated SVG shapes
 * - Purple gradient fills
 * - Continuous floating motion
 * - Low opacity for subtle effect
 * - Fixed positioning behind content
 */
export function PoolBackground() {
  const blobs = useMemo(() => [
    {
      id: 1,
      d: 'M60,-65C75,-55,82,-35,85,-15C88,5,86,25,78,40C70,55,56,65,40,70C24,75,6,75,-10,70C-26,65,-42,55,-55,40C-68,25,-78,5,-80,-18C-82,-41,-76,-67,-62,-77C-48,-87,-24,-81,-2,-78C20,-75,45,-75,60,-65Z',
      duration: 30,
      delay: 0,
      scale: 1.5,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
    },
    {
      id: 2,
      d: 'M45,-55C58,-45,68,-30,70,-14C72,2,66,19,58,33C50,47,40,58,26,64C12,70,-6,71,-22,66C-38,61,-52,50,-61,36C-70,22,-74,5,-72,-13C-70,-31,-62,-50,-50,-61C-38,-72,-19,-75,-1,-73C17,-71,32,-65,45,-55Z',
      duration: 35,
      delay: 5,
      scale: 1.2,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
    },
    {
      id: 3,
      d: 'M50,-60C63,-50,71,-32,74,-14C77,4,75,22,68,37C61,52,49,64,34,70C19,76,1,76,-17,71C-35,66,-53,56,-64,42C-75,28,-79,10,-78,-10C-77,-30,-71,-52,-60,-63C-49,-74,-24,-75,-3,-71C18,-67,37,-70,50,-60Z',
      duration: 40,
      delay: 10,
      scale: 1.8,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
    },
  ], []);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
      {blobs.map((blob) => (
        <motion.div
          key={blob.id}
          className="absolute"
          style={{
            left: blob.left,
            top: blob.top,
            transform: 'translate(-50%, -50%)',
          }}
          animate={{
            x: [0, 100, -50, 75, 0],
            y: [0, -75, 50, -40, 0],
            rotate: [0, 360],
            scale: [blob.scale, blob.scale * 1.1, blob.scale * 0.9, blob.scale],
          }}
          transition={{
            duration: blob.duration,
            delay: blob.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          <svg
            viewBox="-100 -100 200 200"
            width="400"
            height="400"
            style={{ opacity: 0.1 }}
          >
            <defs>
              <linearGradient id={`gradient-${blob.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#7c3aed" />
                <stop offset="50%" stopColor="#9333ea" />
                <stop offset="100%" stopColor="#c084fc" />
              </linearGradient>
              <filter id={`blur-${blob.id}`}>
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
              </filter>
            </defs>
            <path
              d={blob.d}
              fill={`url(#gradient-${blob.id})`}
              filter={`url(#blur-${blob.id})`}
            />
          </svg>
        </motion.div>
      ))}
    </div>
  );
}
