import { ArrowLeft, ArrowRight, Music2, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

export type Toy = 'mascot' | 'piano' | 'book' | 'xylophone';

export function ToyArt({ toy, className = '' }: { toy: Toy; className?: string }) {
  return <span className={`kids-toy-art kids-toy-${toy} ${className}`} aria-hidden="true"
    style={{ backgroundImage: `url(${import.meta.env.BASE_URL}art/maestro-toys.png)` }} />;
}

export function Mascot({ mood = 'rest' }: { mood?: 'rest' | 'happy' | 'hint' | 'dance' }) {
  return <div className={`kids-mascot kids-mascot-${mood}`} aria-hidden="true">
    <ToyArt toy="mascot" />
    {mood === 'dance' || mood === 'happy' ? <Sparkles className="kids-mascot-sparks" /> : null}
  </div>;
}

export function Brand() {
  return <span className="kids-wordmark"><span><Music2 size={21} strokeWidth={2.8} /></span>maestro<span className="kids-brand-period">.</span></span>;
}

export function PracticeHeader({ back, title }: { back: () => void; title: string }) {
  return <div className="kids-practice-nav">
    <button type="button" className="kids-control kids-back" onClick={back}><ArrowLeft size={21} /> Back</button>
    <p>{title}</p>
  </div>;
}

export function ActivityCard({ art, title, description, tone, onClick }: {
  art: ReactNode; title: string; description: string; tone: string; onClick: () => void;
}) {
  return <button type="button" className={`kids-card kids-tone-${tone}`} onClick={onClick}>
    <span className="kids-card-art">{art}</span>
    <span className="kids-card-text"><strong>{title}</strong><span>{description}</span></span>
    <span className="kids-card-arrow"><ArrowRight size={20} /></span>
  </button>;
}
