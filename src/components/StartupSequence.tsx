import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useIsPresent } from 'framer-motion';
import { NativelyLogoMark } from './NativelyLogoMark';
import {
    LIFT, LOGO_OUT, SPLASH_DISMISS_MS, SPLASH_HARD_CAP_MS,
} from './startup/splashTimeline';

interface StartupSequenceProps {
    onComplete: () => void;
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// PrepPilot: a clean splash — the "A" mark, the name and "Made by Aryan" —
// in place of upstream's logo rebuilt from scrolling 0s and 1s. The timers and
// the exit (the logo falls back, the black lifts off the launcher) are unchanged.

const StartupSequence: React.FC<StartupSequenceProps> = ({ onComplete }) => {
    // Keep the latest onComplete in a ref so the timer effect can depend on []
    // and arm EXACTLY ONCE for the splash's lifetime. If the effect depended on
    // `onComplete` directly, an un-memoized caller (a new closure per parent
    // re-render) would tear down and re-arm both timers on every render — and
    // the boot path re-renders many times — so the 5s hard-cap safety net could
    // keep resetting and never fire, trapping the user at the black splash. The
    // ref makes the safety net immune to prop-identity churn regardless of how
    // the caller passes onComplete.
    const onCompleteRef = React.useRef(onComplete);
    onCompleteRef.current = onComplete;

    useEffect(() => {
        // Primary dismiss: the moment the logo has formed. The launcher is mounted
        // behind the splash from here, and the exit uncovers it. These are timers on purpose —
        // Chromium stops requestAnimationFrame for a covered window, and the
        // splash must still hand over to the launcher there.
        const timer = setTimeout(() => {
            onCompleteRef.current();
        }, SPLASH_DISMISS_MS);
        // Hard-cap safety net: no matter what, the splash must never persist past
        // 5s. If the primary timer's onComplete is ever prevented from advancing
        // the app (e.g. a throw upstream, a dropped state update), this guarantees
        // the launcher is revealed rather than leaving the user staring at the
        // black logo — the "stuck at logo" failure mode. Idempotent: onComplete
        // just flips showStartup=false, so a double-call is harmless.
        const hardCap = setTimeout(() => {
            try { onCompleteRef.current(); } catch { /* never let the splash trap the user */ }
        }, SPLASH_HARD_CAP_MS);
        return () => {
            clearTimeout(timer);
            clearTimeout(hardCap);
        };
        // Mount-once: arm the dismissal timers a single time. onComplete is read
        // through onCompleteRef so it is intentionally NOT a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The exit starts when AnimatePresence starts removing the splash, not at
    // the dismiss time: App can hold the splash past it (the welcome gate). App
    // keeps the splash mounted until the exit has ended and removes it; nothing
    // here can delay that.
    const isPresent = useIsPresent();
    const boxRef = useRef<HTMLDivElement>(null);
    const leaving = useRef(false);
    useEffect(() => {
        if (isPresent || leaving.current) return;
        leaving.current = true;
        // the logo is the box's first child: the mark with its name
        const box = boxRef.current, logo = box?.firstElementChild;
        if (!box) return;
        if (!logo || prefersReducedMotion()) {
            // no movement: the still frame dissolves
            box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out', fill: 'forwards' });
            return;
        }
        // The logo falls back into the black, then the black lifts off the
        // launcher underneath. The canvas is a finished frame by now, so this is
        // transform and opacity only: it runs on the compositor and stays smooth
        // while the launcher mounts on the main thread.
        logo.animate([{ transform: 'scale(1)' }, { transform: `scale(${LOGO_OUT.scale})` }], { duration: LOGO_OUT.moveMs, easing: LOGO_OUT.moveEase, fill: 'forwards' });
        logo.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LOGO_OUT.fadeMs, easing: LOGO_OUT.fadeEase, fill: 'forwards' });
        box.animate([{ opacity: 1 }, { opacity: 0 }], { delay: LIFT.at, duration: LIFT.ms, easing: LIFT.ease, fill: 'forwards' });
    }, [isPresent]);

    // Entrance: the mark and its lines rise and fade in once. Reduced motion
    // gets a plain fade.
    const logoRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const logo = logoRef.current;
        if (!logo) return;
        const reduced = prefersReducedMotion();
        logo.animate(
            reduced
                ? [{ opacity: 0 }, { opacity: 1 }]
                : [{ opacity: 0, transform: 'translateY(8px) scale(0.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
            { duration: reduced ? 250 : 600, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' },
        );
    }, []);

    return (
        <div ref={boxRef} className="fixed inset-0 z-[100] bg-[#000000] flex items-center justify-center overflow-hidden">
            <div ref={logoRef} className="flex flex-col items-center text-white select-none">
                <NativelyLogoMark size={88} />
                <div className="mt-5 text-[26px] font-semibold tracking-[-0.02em]">PrepPilot</div>
                <div className="mt-1 text-[13px] text-white/55">Made by Aryan</div>
            </div>
        </div>
    );
};

export default StartupSequence;
