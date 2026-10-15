export function ComposerSpeechError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
      {message}
    </div>
  );
}
