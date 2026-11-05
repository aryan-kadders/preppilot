import React from 'react';

/**
 * PrepPilot wordmark. Upstream drew the lowercase "natively" as SVG letter
 * paths; PrepPilot sets its name in the app's own type at the same height, so
 * every place that used the old wordmark keeps its layout. It takes the text
 * colour of wherever it sits and follows every theme. The component keeps
 * upstream's name so callers are unchanged.
 */
export const NativelyWordmark: React.FC<{
    /** Drawn height in px (the cap height the old wordmark had). */
    height?: number;
    className?: string;
}> = ({ height = 14, className = '' }) => (
    <span
        className={`inline-block font-semibold whitespace-nowrap ${className}`}
        style={{ fontSize: Math.round(height * 1.15), lineHeight: `${height}px`, letterSpacing: '-0.02em' }}
        role="img"
        aria-label="PrepPilot"
    >
        PrepPilot
    </span>
);
