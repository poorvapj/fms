import { useEffect, useMemo, useRef } from 'react';
import { Icon } from './Icon';

const MAX_MB = 15;

/** Pick up to `max` images with thumbnails; used for location photos and completion evidence. */
export function ImagePicker({ files, onChange, max = 5, accept = 'image/*', label = 'Add photo', onError }: {
  files: File[]; onChange: (f: File[]) => void; max?: number; accept?: string; label?: string; onError?: (msg: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((p) => p && URL.revokeObjectURL(p)), [previews]);

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_MB * 1024 * 1024) { onError?.(`${f.name} is larger than ${MAX_MB} MB`); continue; }
      if (accept === 'image/*' && !f.type.startsWith('image/')) { onError?.(`${f.name} is not an image`); continue; }
      if (next.length < max) next.push(f);
    }
    onChange(next);
    if (input.current) input.current.value = '';
  };

  return (
    <div className="upload-list">
      {files.map((f, i) => (
        <div className="upload-item" key={`${f.name}-${i}`}>
          {previews[i] ? <img src={previews[i]!} alt={f.name} /> : <div className="upload-add"><Icon name="file" />{f.name.slice(0, 14)}</div>}
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {files.length < max && (
        <label className="upload-add">
          <span><Icon name="camera" size={20} /><br />{label}</span>
          <input ref={input} type="file" accept={accept} multiple capture={undefined} hidden onChange={(e) => add(e.target.files)} />
        </label>
      )}
    </div>
  );
}
