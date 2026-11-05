import React from 'react';
import { BRAND_MARK_D, BRAND_MARK_VIEWBOX } from '../lib/brandMark';

/**
 * PrepPilot logomark — an "A" inscribed in a ring (src/lib/brandMark.ts).
 * Rendered as inline SVG so it inherits `color` (currentColor) and can be
 * styled freely with className. The component keeps upstream's name so every
 * place that drew the old mark picks up the new one unchanged.
 */
export const NativelyLogoMark: React.FC<{
    size?: number;
    className?: string;
}> = ({ size = 18, className = '' }) => (
    <svg
        width={size}
        height={size}
        viewBox={BRAND_MARK_VIEWBOX}
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
    >
        <path fill="currentColor" d={BRAND_MARK_D} />
    </svg>
);
