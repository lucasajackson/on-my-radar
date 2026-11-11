import { Link } from '@tanstack/react-router';
import type { DashboardQueryResultDto } from '@onmyradar/contract';

/** Consecutive lanes of the same radar, gathered under it, in the order given. */
function byRadar<T extends { radarId: string; name: string }>(
  lanes: readonly T[],
): Array<{ radarId: string; name: string; lanes: T[] }> {
  const out: Array<{ radarId: string; name: string; lanes: T[] }> = [];
  for (const lane of lanes) {
    const last = out[out.length - 1];
    if (last?.radarId === lane.radarId) last.lanes.push(lane);
    else out.push({ radarId: lane.radarId, name: lane.name, lanes: [lane] });
  }
  return out;
}

export function WidgetVisualization({
  data,
  display,
  query,
}: {
  data: DashboardQueryResultDto;
  display: 'count' | 'lanes' | 'activity';
  query?: string;
}) {
  if (display === 'count') {
    const number = (
      <>
        <strong>{data.total.toLocaleString()}</strong>
        <span>matching {data.total === 1 ? 'blip' : 'blips'}</span>
      </>
    );
    return query !== undefined ? (
      <Link
        to="/search"
        search={{ q: query }}
        className="widget-count"
        aria-label={`${data.total} matching blips. Open results`}
      >
        {number}
      </Link>
    ) : (
      <div className="widget-count">{number}</div>
    );
  }
  if (display === 'lanes') {
    const groups = data.laneGroups ?? [];
    const max = Math.max(1, ...groups.map((lane) => lane.total));
    return (
      <div className="widget-lanes">
        {groups.length === 0 ? (
          <p className="note">No matching lanes yet.</p>
        ) : (
          /* One list per radar, its heading outside it. A heading and a bar
             inside a <dl> made a definition list screen readers could not
             walk: a <dl> holds term/description pairs and nothing else. */
          byRadar(groups).map(({ radarId, name, lanes }) => (
            <section key={radarId} aria-label={name}>
              <h3 className="widget-group-heading">{name}</h3>
              <dl>
                {lanes.map((lane) => (
                  <div key={lane.status ?? '_unfiled'} className="widget-lane-row">
                    <dt>{lane.label}</dt>
                    <dd>
                      {lane.total}
                      <span
                        className="widget-lane-bar"
                        aria-hidden="true"
                        style={{ width: `${(lane.total / max) * 100}%` }}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
    );
  }
  const points = data.activity ?? [];
  const max = Math.max(1, ...points.map((point) => point.count));
  const total = points.reduce((sum, point) => sum + point.count, 0);
  const first = points[0]?.date;
  const last = points.at(-1)?.date;
  return (
    <div className="widget-activity">
      <p>
        <strong>{total.toLocaleString()}</strong> captured in{' '}
        {data.activityRange?.days ?? points.length} days
      </p>
      <svg
        viewBox={`0 0 ${Math.max(1, points.length) * 10} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${total} matching blips captured over ${points.length} days, UTC`}
      >
        {points.map((point, index) => (
          <rect
            key={point.date}
            x={index * 10 + 1}
            y={98 - (point.count / max) * 90}
            width={8}
            height={Math.max(1, (point.count / max) * 90)}
          >
            <title>
              {point.date}: {point.count}
            </title>
          </rect>
        ))}
      </svg>
      <div className="widget-chart-axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <details>
        <summary>Daily counts · UTC</summary>
        <table>
          <caption className="sr-only">Matching blips captured each day</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <td>{point.date}</td>
                <td>{point.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
