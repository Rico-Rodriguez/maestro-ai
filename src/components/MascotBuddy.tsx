import type { MascotMood } from './kid-feedback';

export interface MascotBuddyProps {
  mood: MascotMood;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-11 w-11',
  md: 'h-14 w-14',
  lg: 'h-24 w-24',
};

const MOOD_ANIMATION: Record<MascotMood, string> = {
  happy: 'animate-kid-bob',
  cheering: 'animate-kid-cheer',
  encouraging: 'animate-kid-bob',
  dancing: 'animate-kid-sway',
  celebrating: 'animate-kid-cheer',
};

export function MascotBuddy({ mood, size = 'md' }: MascotBuddyProps) {
  const isJoyful = mood === 'cheering' || mood === 'celebrating';
  const isDancing = mood === 'dancing';
  const isEncouraging = mood === 'encouraging';

  return (
    <div
      className={`relative inline-flex shrink-0 items-center justify-center select-none ${SIZE_CLASSES[size]} ${MOOD_ANIMATION[mood]}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 80 80" className="h-full w-full overflow-visible drop-shadow-sm">
        <g className="animate-kid-float">
          <path
            d="M57 18 L57 6 L66 4 L66 15"
            fill="none"
            stroke="#fb7185"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="54.5" cy="18.5" r="3.4" fill="#f59e0b" />
          <circle cx="63.5" cy="15.5" r="3.4" fill="#38bdf8" />
        </g>

        {mood === 'celebrating' ? (
          <g>
            <polygon
              points="40,2 30,22 50,22"
              fill="#fbbf24"
              stroke="#d97706"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <polygon
              points="40,5 41.7,9.2 46.2,9.5 42.7,12.4 43.8,16.8 40,14.4 36.2,16.8 37.3,12.4 33.8,9.5 38.3,9.2"
              fill="#fffbeb"
            />
          </g>
        ) : null}

        <circle cx="20" cy="24" r="10.5" fill="#d97706" />
        <circle cx="20" cy="24" r="6" fill="#fde68a" />
        <circle cx="60" cy="24" r="10.5" fill="#d97706" />
        <circle cx="60" cy="24" r="6" fill="#fde68a" />

        <circle cx="40" cy="44" r="25" fill="#f59e0b" stroke="#b45309" strokeWidth="2" />
        <ellipse cx="40" cy="49" rx="14" ry="11.5" fill="#fef3c7" />

        <circle cx="24" cy="47" r="4.5" fill="#fda4af" opacity="0.72" />
        <circle cx="56" cy="47" r="4.5" fill="#fda4af" opacity="0.72" />

        {isJoyful ? (
          <>
            <path
              d="M27 39 Q30.5 34.5 34 39"
              fill="none"
              stroke="#451a03"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <path
              d="M46 39 Q49.5 34.5 53 39"
              fill="none"
              stroke="#451a03"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
          </>
        ) : isDancing ? (
          <>
            <path
              d="M27 38 Q30.5 34 34 38"
              fill="none"
              stroke="#451a03"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
            <circle cx="49.5" cy="38" r="3" fill="#451a03" />
            <circle cx="50.5" cy="37" r="1" fill="#ffffff" />
          </>
        ) : (
          <>
            <circle cx="30" cy="38.5" r="3.2" fill="#451a03" />
            <circle cx="31" cy="37.4" r="1.1" fill="#ffffff" />
            <circle cx="50" cy="38.5" r="3.2" fill="#451a03" />
            <circle cx="51" cy="37.4" r="1.1" fill="#ffffff" />
          </>
        )}

        <ellipse cx="40" cy="44.5" rx="4.2" ry="3" fill="#78350f" />
        <ellipse cx="38.8" cy="43.8" rx="1.2" ry="0.8" fill="#fef3c7" opacity="0.6" />

        {isJoyful ? (
          <path
            d="M32.5 50.5 Q40 58.5 47.5 50.5 Z"
            fill="#fb7185"
            stroke="#78350f"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ) : isEncouraging ? (
          <path
            d="M34.5 52 Q40 54.5 45.5 52"
            fill="none"
            stroke="#78350f"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M33.5 50.5 Q40 56.5 46.5 50.5"
            fill="none"
            stroke="#78350f"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        )}

        {mood === 'celebrating' ? (
          <>
            <circle cx="11" cy="36" r="2.2" fill="#fbbf24" />
            <circle cx="69" cy="35" r="2.2" fill="#34d399" />
            <circle cx="15" cy="14" r="1.8" fill="#60a5fa" />
            <circle cx="67" cy="12" r="1.8" fill="#f472b6" />
          </>
        ) : null}
      </svg>
    </div>
  );
}

export default MascotBuddy;
