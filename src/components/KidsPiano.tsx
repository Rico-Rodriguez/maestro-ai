import { useEffect, useRef, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { NoteInput } from '../input/types';
import { isBlackKey, noteIdentity, type AidMode } from '../music/kids-learning';
import { getRainbowNoteStyle } from './note-colors';

type Props = {
  notes: number[];
  aids: Exclude<AidMode, 'auto'>;
  target?: number;
  flourish?: boolean;
  playing?: number;
  held: ReadonlySet<number>;
  onInput: (event: NoteInput, pointer?: number) => void;
  bubbles?: boolean;
};

export default function KidsPiano({ notes, aids, target, flourish, playing, held, onInput, bubbles }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const white = notes.filter((pitch) => !isBlackKey(pitch));
  const black = notes.filter(isBlackKey);
  const wide = white.length > 9;
  const centered = playing ?? target ?? (wide ? 60 : undefined);
  useEffect(() => {
    if (centered === undefined) return;
    const frame = wrap.current;
    const key = frame?.querySelector<HTMLElement>(`[data-pitch="${centered}"]`);
    if (!frame || !key) return;
    const box = key.getBoundingClientRect();
    const view = frame.getBoundingClientRect();
    if (box.left < view.left || box.right > view.right) {
      frame.scrollLeft += box.left - view.left - view.width / 2 + box.width / 2;
    }
  }, [centered, wide]);

  function scroll(direction: number) {
    const frame = wrap.current;
    if (frame) frame.scrollBy({ left: direction * frame.clientWidth * 0.8 });
  }

  const press = (pitch: number, pointer?: number) => {
    onInput({ kind: 'on', pitch, velocity: 88, source: 'touch', timeMs: performance.now() }, pointer);
  };
  const release = (pitch: number, pointer?: number) => {
    onInput({ kind: 'off', pitch, source: 'touch', timeMs: performance.now() }, pointer);
  };
  function key(pitch: number, left?: number) {
    const identity = noteIdentity(pitch);
    const color = getRainbowNoteStyle(pitch);
    const sharp = left !== undefined;
    const style = { '--key-color': color.keyBgFrom, left: sharp ? `${left}%` : undefined } as CSSProperties;
    return (
      <button
        key={pitch}
        type="button"
        className={`kids-key${sharp ? ' kids-black-key' : ''}`}
        style={style}
        data-pitch={pitch}
        data-aids={aids}
        data-down={held.has(pitch)}
        data-lit={pitch === target || pitch === playing}
        data-hint={pitch === target && flourish}
        aria-label={`${identity.letter}${Math.floor(pitch / 12) - 1}${aids === 'shapes' ? `, ${identity.colorName} ${identity.shape}` : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          press(pitch, event.pointerId);
        }}
        onPointerUp={(event) => release(pitch, event.pointerId)}
        onPointerCancel={(event) => release(pitch, event.pointerId)}
        onLostPointerCapture={(event) => release(pitch, event.pointerId)}
        onClick={(event) => {
          if (event.detail !== 0) return;
          press(pitch);
          window.setTimeout(() => release(pitch), 160);
        }}
      >
        {aids === 'shapes' && !sharp && <span className="kids-key-symbol" aria-hidden="true">{identity.symbol}</span>}
        {aids !== 'none' && (!sharp || aids === 'letters') && <span aria-hidden="true">{identity.letter}</span>}
      </button>
    );
  }
  return <>
    {wide && <div className="kids-keyboard-scroll">
      <button type="button" className="kids-control" onClick={() => scroll(-1)}><ArrowLeft size={18} /> Lower notes</button>
      <button type="button" className="kids-control" onClick={() => scroll(1)}>Higher notes <ArrowRight size={18} /></button>
    </div>}
    <div className={`kids-keyboard${bubbles ? ' kids-bubbles' : ''}${wide ? ' kids-keyboard-wide' : ''}`} ref={wrap} role="group" aria-label="Piano keys">
      <div className="kids-keybed" style={{ '--white-keys': white.length } as CSSProperties}>
        {white.map((pitch) => key(pitch))}
        {black.map((pitch) => key(pitch, (white.findIndex((natural) => natural === pitch - 1) + 1) * 100 / white.length))}
      </div>
    </div>
  </>;
}
