import { useGuild } from '../GuildContext.jsx';
import { useLive } from '../LiveContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { LiveCard } from '../components/Live.jsx';
import { Icon, Empty } from '../components/ui.jsx';

export default function Live() {
  const { guildId } = useGuild();
  const { live, error } = useLive();

  if (!guildId) return <Page><Empty icon={Icon.Radio} title="No server selected" body="Pick a Discord server to see its live recordings." /></Page>;

  const recording = live.filter((s) => s.phase !== 'processing').length;
  const processing = live.length - recording;
  const counts = [
    recording > 0 && `${recording} recording${recording === 1 ? '' : 's'} in progress`,
    processing > 0 && `${processing} processing`,
  ].filter(Boolean).join(' · ');

  return (
    <Page>
      <PageHead
        title="Live"
        subtitle={counts || 'Real-time view of in-progress recordings'}
      />
      {error && (
        <div className="mb-5 text-sm text-error bg-error-soft rounded-sm px-3 py-2">{error}</div>
      )}
      {live.length === 0 ? (
        <div className="card">
          <Empty
            icon={Icon.Radio}
            title="Nothing recording right now"
            body="When Parley joins a voice channel, the live session shows up here with a timer and a one-click stop. Use /join in Discord or join a voice channel with auto-join on."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {live.map((s) => <LiveCard key={s.meetingId} session={s} />)}
        </div>
      )}
    </Page>
  );
}
