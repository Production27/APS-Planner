// Home dashboard's dismissible "needs you" alert strip — shared by every
// widget that has one (Overdue/Calendar, Workflow/Board, Today/Gantt).
// Split out of home-calendar.tsx once a second widget needed it too (it
// started there since Overdue was the first widget converted). Rendering
// only — the dismiss/persist/signature logic stays in home.ts's
// buildHomeAlertProps(), which every widget's own prop-builder calls.

export interface HomeAlertProps {
  alertId: string;
  text: string;
  tier?: string;
  onDismiss: (e: Event) => void;
}

export function AlertBar(p: HomeAlertProps) {
  const tierClass = p.tier && p.tier !== 'overdue' ? ' tier-' + p.tier : '';
  return (
    <div class={'home-widget-alert' + tierClass} id={'homeAlert-' + p.alertId}>
      <span class="home-widget-alert-text">{p.text}</span>
      <button type="button" class="home-widget-alert-dismiss" onClick={p.onDismiss} title="Dismiss">&times;</button>
    </div>
  );
}
