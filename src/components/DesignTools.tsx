// Design Utilities tab (Step 14) — all client-side, pure browser JS:
// palette generator, favicon generator (canvas → PNG), SEO/meta generator
// (executes the applet-seo skill checklist as code), contrast checker and
// image compressor. No server calls, no provider calls, no new deps.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Palette, FileImage, Globe, Contrast, ImageDown, Download, Copy, Check, Loader2 } from 'lucide-react';
import {
  isValidHex, normalizeHex, generatePalette,
  contrastVerdict, buildSeoMeta, downloadTextFile,
} from '../lib/designUtils';

type SubTab = 'palette' | 'favicon' | 'seo' | 'contrast' | 'compress';

const SUB_TABS: Array<{ id: SubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'palette', label: 'Palette', icon: Palette },
  { id: 'favicon', label: 'Favicon', icon: FileImage },
  { id: 'seo', label: 'SEO / Meta', icon: Globe },
  { id: 'contrast', label: 'Contrast', icon: Contrast },
  { id: 'compress', label: 'Compress Image', icon: ImageDown },
];

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
      title={label || 'Copy'}
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export const DesignTools: React.FC = () => {
  const [subTab, setSubTab] = useState<SubTab>('palette');

  // --- Palette ---
  const [baseColor, setBaseColor] = useState('#6366f1');
  const palette = isValidHex(baseColor) ? generatePalette(normalizeHex(baseColor), 6) : [];

  // --- Favicon ---
  const [favLetter, setFavLetter] = useState('N');
  const [favBg, setFavBg] = useState('#4f46e5');
  const [favFg, setFavFg] = useState('#ffffff');
  const [favSize, setFavSize] = useState(64);
  const [favDataUrl, setFavDataUrl] = useState<string | null>(null);
  const favCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (subTab !== 'favicon') return;
    const canvas = favCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = favSize;
    canvas.height = favSize;
    const radius = Math.round(favSize * 0.18);
    ctx.clearRect(0, 0, favSize, favSize);
    ctx.fillStyle = favBg;
    ctx.beginPath();
    ctx.roundRect(0, 0, favSize, favSize, radius);
    ctx.fill();
    ctx.fillStyle = favFg;
    ctx.font = `bold ${Math.round(favSize * 0.62)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((favLetter || 'N').slice(0, 2).toUpperCase(), favSize / 2, favSize / 2 + favSize * 0.03);
    setFavDataUrl(canvas.toDataURL('image/png'));
  }, [subTab, favLetter, favBg, favFg, favSize]);

  // --- SEO ---
  const [seoTitle, setSeoTitle] = useState('My Awesome Website');
  const [seoDesc, setSeoDesc] = useState('A fast, beautiful website built with Nexus AI.');
  const [seoUrl, setSeoUrl] = useState('https://example.com/');
  const [seoImage, setSeoImage] = useState('');
  const [seoSiteName, setSeoSiteName] = useState('');
  const [seoAuthor, setSeoAuthor] = useState('');
  const seo = buildSeoMeta({ title: seoTitle, description: seoDesc, url: seoUrl, image: seoImage, siteName: seoSiteName, author: seoAuthor });

  // --- Contrast ---
  const [fgColor, setFgColor] = useState('#ffffff');
  const [bgColor, setBgColor] = useState('#111827');
  const verdict = isValidHex(fgColor) && isValidHex(bgColor) ? contrastVerdict(normalizeHex(fgColor), normalizeHex(bgColor)) : null;

  // --- Image compressor ---
  const [srcInfo, setSrcInfo] = useState<{ name: string; size: number; width: number; height: number } | null>(null);
  const [srcDataUrl, setSrcDataUrl] = useState<string | null>(null);
  const [maxDim, setMaxDim] = useState(1280);
  const [quality, setQuality] = useState(0.8);
  const [outInfo, setOutInfo] = useState<{ size: number; width: number; height: number; dataUrl: string } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const onPickImage = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onload = () => {
        setSrcInfo({ name: file.name, size: file.size, width: img.naturalWidth, height: img.naturalHeight });
        setSrcDataUrl(dataUrl);
        setOutInfo(null);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, []);
  const runCompress = useCallback(() => {
    if (!srcDataUrl || !srcInfo) return;
    setCompressing(true);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { setCompressing(false); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { setCompressing(false); return; }
        const url = URL.createObjectURL(blob);
        const reader = new FileReader();
        reader.onload = () => {
          setOutInfo({ size: blob.size, width: w, height: h, dataUrl: String(reader.result || '') });
          setCompressing(false);
        };
        reader.readAsDataURL(blob);
        void url;
      }, 'image/jpeg', quality);
    };
    img.src = srcDataUrl;
  }, [srcDataUrl, srcInfo, maxDim, quality]);

  const fmtKb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

  return (
    <div className="space-y-4">
      <p className="text-slate-400">
        Design utilities that run entirely in your browser — no server call, no AI model, no key needed.
      </p>

      <div className="flex gap-1.5 flex-wrap">
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border cursor-pointer ${
                subTab === t.id ? 'bg-indigo-600/25 border-indigo-500 text-indigo-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {subTab === 'palette' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-slate-300 font-medium">Base colour:</label>
            <input type="color" value={isValidHex(baseColor) ? normalizeHex(baseColor) : '#6366f1'} onChange={(e) => setBaseColor(e.target.value)} className="w-10 h-8 bg-slate-900 border border-slate-700 rounded-lg cursor-pointer" />
            <input type="text" value={baseColor} onChange={(e) => setBaseColor(e.target.value)} spellCheck={false} className="w-28 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500" />
            {!isValidHex(baseColor) && <span className="text-rose-400">Enter a hex colour like #6366f1.</span>}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {palette.map((c) => (
              <button key={c} onClick={() => navigator.clipboard.writeText(c)} className="rounded-xl overflow-hidden border border-slate-800 text-left cursor-pointer group" title={`${c} — click to copy`}>
                <div className="h-16 w-full" style={{ backgroundColor: c }} />
                <div className="bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 group-hover:text-white">{c}</div>
              </button>
            ))}
          </div>
          <p className="text-slate-500 text-[11px]">Harmonious scheme: base, two analogous neighbours, complement, and light + dark shades. Click a swatch to copy its hex.</p>
        </div>
      )}

      {subTab === 'favicon' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-slate-300 font-medium">Letter(s):</label>
            <input type="text" value={favLetter} maxLength={2} onChange={(e) => setFavLetter(e.target.value)} className="w-16 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500" />
            <label className="text-slate-300 font-medium">Background:</label>
            <input type="color" value={favBg} onChange={(e) => setFavBg(e.target.value)} className="w-10 h-8 bg-slate-900 border border-slate-700 rounded-lg cursor-pointer" />
            <label className="text-slate-300 font-medium">Text:</label>
            <input type="color" value={favFg} onChange={(e) => setFavFg(e.target.value)} className="w-10 h-8 bg-slate-900 border border-slate-700 rounded-lg cursor-pointer" />
            <label className="text-slate-300 font-medium">Size:</label>
            <select value={favSize} onChange={(e) => setFavSize(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded-xl px-2 py-2 text-white text-xs">
              {[16, 32, 48, 64, 128, 180, 192, 512].map((s) => (<option key={s} value={s}>{s}×{s}</option>))}
            </select>
          </div>
          <div className="flex items-center gap-4">
            <canvas ref={favCanvasRef} className="rounded-lg border border-slate-800 bg-slate-950" style={{ width: 96, height: 96 }} />
            {favDataUrl && (
              <div className="space-y-2">
                <p className="text-slate-400">PNG rendered on a canvas in your browser — no upload.</p>
                <a href={favDataUrl} download={`favicon-${favSize}.png`} className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold cursor-pointer">
                  <Download className="w-3.5 h-3.5" /> Download favicon-{favSize}.png
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'seo' && (
        <div className="space-y-3">
          <p className="text-slate-400">Runs the <code className="text-indigo-300">applet-seo</code> checklist as code: synced title / description / OpenGraph / Twitter card, canonical URL and JSON-LD.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input type="text" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} placeholder="Page title (≤ 60 chars)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500" />
            <input type="text" value={seoUrl} onChange={(e) => setSeoUrl(e.target.value)} placeholder="Page URL (https://…)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500" />
            <input type="text" value={seoDesc} onChange={(e) => setSeoDesc(e.target.value)} placeholder="Meta description (≤ 160 chars)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 md:col-span-2" />
            <input type="text" value={seoImage} onChange={(e) => setSeoImage(e.target.value)} placeholder="Social preview image URL (optional)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500" />
            <input type="text" value={seoSiteName} onChange={(e) => setSeoSiteName(e.target.value)} placeholder="Site name (optional)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500" />
            <input type="text" value={seoAuthor} onChange={(e) => setSeoAuthor(e.target.value)} placeholder="Author (optional, for JSON-LD)" className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {seo.checklist.map((c) => (
              <span key={c.item} title={c.hint || c.item} className={`px-2 py-1 rounded-lg text-[11px] font-medium border ${c.ok ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-amber-500/10 text-amber-300 border-amber-500/30'}`}>
                {c.ok ? '✓' : '•'} {c.item}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-300 font-medium">Paste into &lt;head&gt; of index.html:</span>
            <div className="flex gap-2">
              <CopyButton text={seo.headSnippet} label="Copy head snippet" />
              <button onClick={() => downloadTextFile('seo-head.html', seo.headSnippet, 'text/html')} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer">
                <Download className="w-3 h-3" /> Download
              </button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-emerald-300 bg-slate-950 p-3 rounded-xl border border-slate-800 leading-relaxed max-h-64 overflow-y-auto">{seo.headSnippet}</pre>
        </div>
      )}

      {subTab === 'contrast' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-slate-300 font-medium">Text:</label>
            <input type="color" value={isValidHex(fgColor) ? normalizeHex(fgColor) : '#ffffff'} onChange={(e) => setFgColor(e.target.value)} className="w-10 h-8 bg-slate-900 border border-slate-700 rounded-lg cursor-pointer" />
            <input type="text" value={fgColor} onChange={(e) => setFgColor(e.target.value)} spellCheck={false} className="w-28 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500" />
            <label className="text-slate-300 font-medium">Background:</label>
            <input type="color" value={isValidHex(bgColor) ? normalizeHex(bgColor) : '#111827'} onChange={(e) => setBgColor(e.target.value)} className="w-10 h-8 bg-slate-900 border border-slate-700 rounded-lg cursor-pointer" />
            <input type="text" value={bgColor} onChange={(e) => setBgColor(e.target.value)} spellCheck={false} className="w-28 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500" />
          </div>
          {verdict ? (
            <div className="space-y-2">
              <div className="p-4 rounded-xl border border-slate-800" style={{ backgroundColor: normalizeHex(bgColor), color: normalizeHex(fgColor) }}>
                <p className="font-bold text-sm">The quick brown fox jumps over the lazy dog</p>
                <p className="text-xs opacity-80">Sample text at {verdict.ratio.toFixed(2)}:1 contrast on this background.</p>
              </div>
              <p className="text-white font-bold">
                Contrast {verdict.ratio.toFixed(2)}:1 — grade {verdict.grade}
              </p>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className={`px-2 py-1 rounded-lg border ${verdict.aaNormal ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>AA normal (≥ 4.5): {verdict.aaNormal ? 'pass' : 'fail'}</span>
                <span className={`px-2 py-1 rounded-lg border ${verdict.aaLarge ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>AA large (≥ 3): {verdict.aaLarge ? 'pass' : 'fail'}</span>
                <span className={`px-2 py-1 rounded-lg border ${verdict.aaaNormal ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>AAA normal (≥ 7): {verdict.aaaNormal ? 'pass' : 'fail'}</span>
                <span className={`px-2 py-1 rounded-lg border ${verdict.aaaLarge ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>AAA large (≥ 4.5): {verdict.aaaLarge ? 'pass' : 'fail'}</span>
              </div>
            </div>
          ) : (
            <p className="text-rose-400">Enter two valid hex colours.</p>
          )}
        </div>
      )}

      {subTab === 'compress' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold cursor-pointer flex items-center gap-1.5">
              <ImageDown className="w-3.5 h-3.5" /> Choose image…
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); }} />
            </label>
            {srcInfo && (
              <span className="text-slate-300">{srcInfo.name} — {srcInfo.width}×{srcInfo.height} · {fmtKb(srcInfo.size)}</span>
            )}
          </div>
          {srcInfo && (
            <>
              <div className="flex flex-wrap items-center gap-4">
                <label className="text-slate-300 font-medium">Max dimension: <span className="text-white font-mono">{maxDim}px</span></label>
                <input type="range" min={256} max={2048} step={64} value={maxDim} onChange={(e) => setMaxDim(Number(e.target.value))} className="w-40" />
                <label className="text-slate-300 font-medium">Quality: <span className="text-white font-mono">{Math.round(quality * 100)}%</span></label>
                <input type="range" min={0.1} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-40" />
                <button onClick={runCompress} disabled={compressing} className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer">
                  {compressing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageDown className="w-3.5 h-3.5" />} Compress (JPEG)
                </button>
              </div>
              {outInfo && (
                <div className="space-y-2">
                  <p className="text-slate-300">
                    Result: {outInfo.width}×{outInfo.height} · {fmtKb(outInfo.size)}
                    {srcInfo && <> — <span className="text-emerald-400 font-bold">{Math.max(0, Math.round((1 - outInfo.size / srcInfo.size) * 100))}% smaller</span></>}
                  </p>
                  <div className="flex items-center gap-3">
                    <img src={outInfo.dataUrl} alt="Compressed preview" className="max-h-40 rounded-xl border border-slate-800" />
                    <a href={outInfo.dataUrl} download="compressed.jpg" className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold cursor-pointer">
                      <Download className="w-3.5 h-3.5" /> Download compressed.jpg
                    </a>
                  </div>
                </div>
              )}
            </>
          )}
          <p className="text-slate-500 text-[11px]">The image never leaves your browser — it is resized and re-encoded on a canvas and downloaded as JPEG.</p>
        </div>
      )}
    </div>
  );
};
