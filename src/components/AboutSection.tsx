import React from 'react';
import { useT } from '../i18n';
import {
    Github,
    NotebookPen, Pin, Plug, Link,
    LayoutGrid, Search, FileText, PlayCircle,
    HardDrive, Sliders, Lock, ArrowRight, Mail,
} from 'lucide-react';
import { ProfileIntelligenceIcon } from './ProfileIntelligenceIcon';
// Each platform's own app icon: the Liquid Glass render macOS shows in the Dock
// (assets/icons/mac/dock-icon.png) and the Windows icon (assets/icons/png), at
// 192px for an 80px header.
import appIconMac from '../assets/about/app-icon-mac.webp';
import appIconWin from '../assets/about/app-icon-win.webp';
import { isMac, isWindows } from '../utils/platformUtils';
import { getPlatformFacts } from '../lib/helpContent.mjs';
import { APP_FEATURE_VERSION } from '../utils/appVersion';
import { LiquidGlassBadge } from '../ui-components/LiquidGlassBadge';
import { SETTINGS_BTN, SettingsRow, SettingsSectionHeading } from './settings/SettingsRow';
// The learn-more hover (.t-learn).
import './settings/HowItWorksRefund.css';

// Built from the AI Providers panel's `.aip-*` system (the same one Retrieval
// adopts), so About reads as part of Settings rather than its own UI: aip-card
// surfaces, rows split by --aip-divider hairlines, and colour only where
// something carries a state.

// ABOUT_CSS is About's own layer OVER that system — three additions, no
// overrides, so AI Providers / Retrieval / Embedding (which all share AIP_CSS)
// cannot be reached from here. Kept in its own literal and concatenated at the
// single trailing <style>, because AIP_CSS is exported and shared.
//
// Container queries rather than Tailwind's `md:` / `lg:`: Settings is a
// `w-full max-w-4xl` modal with a `w-64` (256px) sidebar and `p-8` on the
// panel, so this column CAPS at ~576px and shrinks with the window — measured
// at 574px on a maximised window. A viewport breakpoint knows none of that:
// `md:` and `lg:` both fire off the window, which is how the pipeline grid
// came to render three ~190px columns inside 574px. `@container` measures the
// column itself, so it also handles the narrow-window case the viewport
// version got backwards. Written raw because tailwind.config.js has
// `plugins: []` — no container-queries plugin.
//
// (No backticks in this CSS: ABOUT_CSS is a template literal, as AIP_CSS is.)
type AboutIcon = React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;

/**
 * A row of About. Glyphs are neutral, as in every other Settings pane; `go` is
 * where the thing lives, so the row can take you there.
 */
type AboutGo = { tab: string; label: string } | 'modes' | 'profile' | 'search' | { meeting: string; label: string };

// The meeting every install is seeded with (DatabaseManager.seedDemoMeeting).
const DEMO_MEETING_ID = 'demo-meeting';
interface AboutItem { title: string; body: string; badge?: string; Icon: AboutIcon; go?: AboutGo }

// Every claim below was checked against the code on 2026-09-30. What's New
// names where a feature lives in its line ("In Retrieval") rather than with a
// button (the owner's call); a row that does carry a button keeps its line
// under ~55 characters so it stays on one line beside it.
// 3.0, the owner's picks (2026-11-01) from the commits since v2.9.2:
// Notepad (#649, 55933295: recipes, live transcript, Ask that reads the
// whole meeting), your own overlay buttons (bd462875, Settings › Overlay
// "Your buttons", written from plain sentences), Connectors (Settings ›
// Connectors: Gmail, Slack, Notion, CRMs, Zapier, webhooks), share notes as
// a link (#657, the meeting's Share menu), and follow-up emails in your
// style (meeting header compose sheet; style per mode in Modes Manager).
// Undetectable is deliberately not claimed here: the owner won't promise it.
// Nothing here needs the Companion extension.
const WHATS_NEW: AboutItem[] = [
    { title: 'Notepad', body: 'Notes with recipes, a live transcript and Ask for the whole meeting.', Icon: NotebookPen },
    { title: 'Your own overlay buttons', body: 'Describe a button in plain sentences and PrepPilot builds it. In Overlay.', Icon: Pin },
    { title: 'Connectors', body: 'Gmail, Slack, Notion, Zapier, CRMs and webhooks. In Connectors.', Icon: Plug },
    { title: 'Share notes as a link', body: 'Send anyone a link to a meeting’s notes. In the Share menu.', Icon: Link },
    { title: 'Follow-ups in your style', body: 'One click writes the follow-up email in your tone, per mode.', Icon: Mail },
];

// Compressed 2026-09-25 at the owner's request. Not numbered: they are not a
// pipeline ("Modes" is not step three of anything).
const HOW_IT_WORKS: AboutItem[] = [
    { title: 'Modes', body: 'Templates like Sales or Interview, plus your own.', Icon: LayoutGrid, go: 'modes' },
    { title: 'Profile Intelligence', body: 'Resume, job description and company intel.', Icon: ProfileIntelligenceIcon, go: 'profile' },
    { title: 'Searches files and meetings', body: 'Indexed locally, on-device or cloud.', Icon: Search, go: 'search' },
    { title: 'Notes after every meeting', body: 'Structured notes and open questions.', Icon: FileText, go: { meeting: DEMO_MEETING_ID, label: 'Demo meeting' } },
];

// The last "How it works" row points at Setup & Help. It promises a recording
// only where Setup & Help shows one (helpContent.mjs `clips.answer`: macOS);
// elsewhere Setup & Help opens on the answer-flow figure and its guides.
const SEE_IT_RECORDING: AboutItem = { title: 'See it in action', body: 'A recording of PrepPilot answering a question.', Icon: PlayCircle, go: { tab: 'help', label: 'Setup & Help' } };
const SEE_IT_GUIDES: AboutItem = { title: 'Setup and guides', body: 'Every part of PrepPilot, step by step.', Icon: PlayCircle, go: { tab: 'help', label: 'Setup & Help' } };

function helpShowsRecording(): boolean {
    const platform = isMac ? 'darwin' : isWindows ? 'win32' : null;
    return platform ? getPlatformFacts(platform).clips.answer : false;
}

const PRIVACY: AboutItem[] = [
    { title: 'Stored on your device', body: 'Local database. Audio is never saved.', Icon: HardDrive },
    { title: 'You decide what is sent', body: 'Audio to speech, text to AI. Local sends nothing.', Icon: Sliders },
    { title: 'Keys are encrypted', body: "In your OS secure storage.", Icon: Lock },
];

// PrepPilot is a personal fork of Natively. The licence asks that the
// original stays credited, so About links back to it.
const UPSTREAM_URL = 'https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant';

// About is built from `./settings/SettingsRow` — the module General, Audio,
// Companion, Intelligence and Provider Performance are built from, whose own header
// says it exists "so a pane that adopts the Settings look takes the same
// measurements rather than a copy of them". About previously used the `aip-*`
// sheet from AI Providers, which is that panel's own dialect at its own scale
// (15px/600 headings, 26px tiles, 11px body) — correct for a dense credential
// panel, wrong for a reading pane sitting next to General in the same nav, and
// the reason About read as a different product.
//
// Every measurement below is therefore imported rather than restated:
//   panel heading   18px/700 + 12px sub   SettingsSectionHeading
//   row             [40px tile][14px/700 title (+badge)][12px description][control]
//   icon glyph      20px, as General, Keybinds, Audio and Intelligence pass it
//   group gap       space-y-6
// Nothing here re-declares a colour, a radius or a size that the module owns.

// General's row container, verbatim. The 1px TRANSPARENT border is load-bearing:
// SettingsRow carries the matching `border-x border-transparent`, and together
// they set the tiles 1px in from the section heading. General also carries
// `divide-y divide-border-subtle/20`, which is dead — Tailwind 3 cannot
// recompute alpha on a bare var() colour, so it emits no CSS and General's rows
// have no dividers at all. Verified against dist/assets/*.css (0 occurrences),
// and deliberately not reproduced: rows here separate by rhythm, as General's do.
const ROW_GROUP = 'rounded-xl border bg-transparent border-transparent';

interface AboutSectionProps {
    /** Switches the Settings tab — the rows' buttons use it to take you to a feature. */
    onNavigate?: (tab: string) => void;
    /** Hands Settings over to the Modes manager / Profile Intelligence. */
    onOpenModes?: () => void;
    onOpenProfile?: () => void;
    /** Closes Settings and opens the Launcher's search bar / a meeting. */
    onOpenSearch?: () => void;
    onOpenMeeting?: (id: string) => void;
}

/**
 * A button in a row's control rail that takes you somewhere: "Modes →" —
 * Setup & Help's GoButton, at one of two widths so neighbours match: the short
 * labels (Modes, Profile, Search; widest measured 87px) and the long ones
 * (Demo meeting, Setup & Help; widest 131px). min-width, not width, so a
 * longer translation still grows.
 */
const GoButton: React.FC<{ label: string; onClick: () => void; wide?: boolean }> = ({ label, onClick, wide }) => (
    // t-learn: the arrow leans 2px toward where the button goes on hover
    // (transitions.dev "learn more hover", HowItWorksRefund.css).
    <button type="button" onClick={onClick} className={`t-learn ${SETTINGS_BTN} ${wide ? 'min-w-[132px]' : 'min-w-[88px]'}`}>
        {label}
        <span className="t-learn-chevron" aria-hidden="true"><ArrowRight size={13} /></span>
    </button>
);

export const AboutSection: React.FC<AboutSectionProps> = ({ onNavigate, onOpenModes, onOpenProfile, onOpenSearch, onOpenMeeting }) => {
    const t = useT();
    const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
    const buildCommit = import.meta.env.VITE_BUILD_COMMIT || 'unknown';

    const openLink = (url: string) => {
        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    };

    // A row's glyph (neutral, the tile's own colour), and the button that takes
    // you to the feature.
    // A destination the host didn't wire (no onNavigate in a harness, say)
    // leaves the row without a button rather than with a dead one.
    const rowIcon = ({ Icon }: AboutItem) => <Icon size={20} />;
    const rowGo = ({ go }: AboutItem): React.ReactNode => {
        if (!go) return undefined;
        if (go === 'modes') return onOpenModes && <GoButton label={t('Modes')} onClick={onOpenModes} />;
        if (go === 'profile') return onOpenProfile && <GoButton label={t('Profile')} onClick={onOpenProfile} />;
        if (go === 'search') return onOpenSearch && <GoButton label={t('Search')} onClick={onOpenSearch} />;
        if ('meeting' in go) return onOpenMeeting && <GoButton wide label={t(go.label)} onClick={() => onOpenMeeting(go.meeting)} />;
        return onNavigate && <GoButton wide label={t(go.label)} onClick={() => onNavigate(go.tab)} />;
    };
    const shortCommit = buildCommit !== 'unknown' ? buildCommit.slice(0, 7) : null;
    const versionLine = `${t('Version')} ${appVersion}${shortCommit ? ` (${shortCommit})` : ''}`;

    return (
        // General's own shell: space-y-6, and the stagger attribute is the ONLY
        // entrance. General pairs it with "animated fadeIn", which is dead —
        // neither `.animated` nor `.fadeIn` exists in any stylesheet (0 hits in
        // dist/assets/*.css), so copying it would have copied nothing.
        <div className="space-y-6 pb-10" data-settings-stagger>
            {/* The header, as About This Mac draws one: the app's icon, its name,
                and the version. The one element off the row grid — it is the
                page's title, not a section. The build moved up here from the
                footnote under Community, where it sat a screen away from the
                question "which version am I on?". */}
            <header className="flex flex-col items-center text-center pt-1">
                <img
                    src={isMac ? appIconMac : appIconWin}
                    alt=""
                    // The macOS render carries the Dock's own margin and shadow; the
                    // Windows icon is full-bleed, so it is drawn smaller to match.
                    className={isMac ? 'w-[88px] h-[88px]' : 'w-[76px] h-[76px] my-1.5'}
                    draggable={false}
                />
                <h2 className="mt-2 text-[22px] leading-7 font-bold tracking-[-0.02em] text-text-primary">PrepPilot</h2>
                <div className="mt-0.5 text-xs text-text-secondary tabular-nums select-text">{versionLine}</div>
            </header>

            <section>
                <SettingsSectionHeading
                    title={`${t("What's New in")} v${APP_FEATURE_VERSION}`}
                    subtitle={t('The changes you can see in this release.')}
                />
                <div className={ROW_GROUP}>
                    {WHATS_NEW.map((item) => (
                        <SettingsRow
                            key={item.title}
                            icon={rowIcon(item)}
                            title={t(item.title)}
                            /* The app's own tag. `neutral` is its documented default
                               because "a tag qualifies the thing beside it rather than
                               competing with it", and it is the only variant that clears
                               the AA floor at 9.5px type. */
                            badge={item.badge ? <LiquidGlassBadge variant="neutral">{t(item.badge)}</LiquidGlassBadge> : undefined}
                            description={t(item.body)}
                            control={rowGo(item)}
                        />
                    ))}
                </div>
            </section>

            <section>
                <SettingsSectionHeading
                    title={t('How PrepPilot Works')}
                    subtitle={t('From the conversation to the answer.')}
                />
                <div className={ROW_GROUP}>
                    {[...HOW_IT_WORKS, helpShowsRecording() ? SEE_IT_RECORDING : SEE_IT_GUIDES].map((item) => (
                        <SettingsRow key={item.title} icon={rowIcon(item)} title={t(item.title)} description={t(item.body)} control={rowGo(item)} />
                    ))}
                </div>
            </section>

            <section>
                <SettingsSectionHeading
                    title={t('Privacy & Data')}
                    subtitle={t('What stays local, and what you send.')}
                />
                <div className={ROW_GROUP}>
                    {PRIVACY.map((item) => (
                        <SettingsRow key={item.title} icon={rowIcon(item)} title={t(item.title)} description={t(item.body)} />
                    ))}
                </div>
            </section>

            {/* Where a review is written. Its own section, above the closing one:
                the rows below it all leave the app (GitHub, Telegram, mail), and
                this one does not. */}
            <section>
                <SettingsSectionHeading
                    title={t('Credits')}
                    subtitle={t('PrepPilot is a personal, non-commercial build.')}
                />
                <div className={ROW_GROUP}>
                    <SettingsRow
                        icon={<Github size={20} />}
                        title="Natively"
                        description={t('This project is based on Natively, originally developed by Natively AI Private Limited.')}
                        control={
                            <button type="button" onClick={() => openLink(UPSTREAM_URL)} className={SETTINGS_BTN}>
                                {t('View source')}
                            </button>
                        }
                    />
                </div>
            </section>
        </div>
    );
};
