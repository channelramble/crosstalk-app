import type { Member, Room, Turn } from "@crosstalk/shared";

export function currentTurn(member: Member, turns: Turn[]): Turn | undefined {
  return turns.filter((t) => t.memberId === member.id && (t.status === "running" || t.status === "queued"))
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt - b.createdAt)[0];
}

export function workOrder(room: Room, members: Member[], turns: Turn[]) {
  const builder = members.find((m) => m.id === room.leadMemberId) ?? members[0];
  const reviewer = members.find((m) => m.id !== builder?.id);
  const running = members.filter((m) => ["thinking", "working", "approval"].includes(m.status));
  const queued = members.filter((m) => m.status === "queued");
  const isReview = (turn: Turn | undefined) => !!turn && (turn.origin === "loop" || (turn.origin == null && turn.hop > 0));
  const role = (m: Member) => {
    if (room.mode !== "review") return "Working";
    const turn = currentTurn(m, turns);
    if (m.id === reviewer?.id) return isReview(turn) ? "Reviewing" : "Answering";
    if (m.id === builder?.id) return turn?.origin === "loop" || (turn?.origin == null && (turn?.hop ?? 0) > 0) ? "Improving" : "Building";
    return "Working";
  };
  const steps = running.map((member) => ({ member, when: "Now", action: member.status === "approval" ? "Waiting for your approval" : role(member) }));
  for (const member of queued) steps.push({ member, when: queued.length === 1 ? "Next" : "Queued", action: role(member) });
  let note = "";
  let round: number | null = null;
  if (room.mode === "review" && running.length === 1 && builder && reviewer) {
    const member = running[0];
    const turn = currentTurn(member, turns);
    const building = member.id === builder.id;
    const loopStep = building || (member.id === reviewer.id && isReview(turn));
    if (turn && loopStep) {
      // Explicit reviewer questions and third-agent hand-offs can precede the build, so hop parity isn't a round count.
      round = turn.origin != null && turn.chainId
        ? turns.filter((t) => t.chainId === turn.chainId && t.memberId === reviewer.id && t.origin === "loop" && t.status === "done").length + 1
        : member.id === reviewer.id ? Math.ceil(turn.hop / 2) || 1 : Math.floor(turn.hop / 2) + 1;
    }
    // A future builder step needs enough room for its review too.
    const fits = !!turn && turn.hop + (building ? 1 : 2) <= room.maxHops;
    if (!queued.length && turn && loopStep && fits) {
      steps.push({ member: building ? reviewer : builder, when: building ? "Planned next" : "If fixes are needed", action: building ? "Reviewing" : "Improving" });
      note = building ? "Review follows a successful build. The loop may pause for your input." : "Approval finishes the task; otherwise the builder makes the fixes.";
    } else if (!queued.length && turn && loopStep && !fits) note = "This is the last step at the room's current round limit.";
    else if (member.id === reviewer.id && turn && !loopStep) note = "Answering your request. A new build starts only if the reviewer asks the builder to act.";
  }
  return { steps, note, round, together: running.length > 1 };
}
