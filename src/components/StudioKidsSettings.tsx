import { Check, Circle } from 'lucide-react';
import { SONGS, STAGES, learningStage, type KidsData, type KidsSettings } from '../music/kids-learning';

export const STUDIO_SECTIONS = [
  ['profile', 'Child profile'], ['learning', 'Learning'], ['piano', 'Piano'],
  ['sound', 'Sound'], ['connect', 'Connect a piano'], ['music', 'Music studio'],
] as const;
export type StudioSection = typeof STUDIO_SECTIONS[number][0];

type Props = {
  section: StudioSection;
  data: KidsData;
  onSettings: (settings: Partial<KidsSettings>) => void;
};

export default function StudioKidsSettings({ section, data, onSettings }: Props) {
  const stage = learningStage(data);
  const complete = data.skills.includes('solo') && data.skills.length === STAGES.length;
  if (section === 'profile') return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-extrabold">Learning journey</h3>
        <ol className="mt-2 grid gap-2.5">
          {STAGES.map((level, index) => <li key={level.title} className="flex items-start gap-2 text-sm">
            {index < stage || complete ? <Check size={17} className="mt-0.5 shrink-0 text-[#19845d]" /> : <Circle size={16} className="mt-0.5 shrink-0 opacity-50" />}
            <div><strong>{level.title}</strong>{index === stage && !complete && <span className="ml-2 text-xs font-bold">In progress</span>}
              <p className="text-xs opacity-75">{level.skill}</p>
            </div>
          </li>)}
        </ol>
      </div>
      <div>
        <h3 className="text-sm font-extrabold">Song progress</h3>
        <ul className="mt-2 grid gap-2">
          {SONGS.map(({ score, phrases }) => {
            const guided = data.songs[`${score.id}:guided`]?.best ?? 0;
            const solo = data.songs[`${score.id}:solo`]?.best ?? 0;
            const phrasesDone = (notes: number) => Math.min(phrases.length, notes === score.events.length ? phrases.length : Math.floor(notes / 4));
            return <li key={score.id} className="rounded-xl border border-current/10 px-3 py-2">
              <strong className="text-sm">{score.title}</strong>
              <p className="text-xs opacity-75">Guided {phrasesDone(guided)}/{phrases.length} · Independent {phrasesDone(solo)}/{phrases.length}</p>
            </li>;
          })}
        </ul>
      </div>
    </div>
  );
  if (section === 'learning') return (
    <label className="mb-4 flex flex-wrap items-center gap-2 text-sm font-bold">
      <input type="checkbox" className="h-4 w-4 accent-[#b72355]" checked={data.settings.voice}
        onChange={(event) => onSettings({ voice: event.target.checked })} />
      Spoken guidance in Maestro Kids
    </label>
  );
  if (section === 'piano') return (
    <div className="mb-4 flex flex-wrap gap-3">
      <label className="grid gap-1 text-sm font-bold">Kids keyboard
        <select className="rounded-lg border border-current/20 bg-transparent p-2" value={data.settings.keys}
          onChange={(event) => onSettings({ keys: event.target.value as KidsSettings['keys'] })}>
          <option value="auto">Match learning stage</option><option value="one">1 white key</option>
          <option value="three">3 white keys</option><option value="five">5 white keys</option>
          <option value="seven">7 white keys</option><option value="chromatic">White and black keys</option>
          <option value="full">Full 88-key piano</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Kids note aids
        <select className="rounded-lg border border-current/20 bg-transparent p-2" value={data.settings.aids}
          onChange={(event) => onSettings({ aids: event.target.value as KidsSettings['aids'] })}>
          <option value="auto">Match learning stage</option><option value="shapes">Colors, shapes and letters</option>
          <option value="letters">Letters</option><option value="none">No labels</option>
        </select>
      </label>
    </div>
  );
  if (section === 'connect') return <p className="mb-4 text-sm opacity-80">A connected piano can play the on-screen keys in Maestro Kids. Acoustic mode listens for individual pitches while the microphone is on.</p>;
  return null;
}
