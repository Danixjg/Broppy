import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { countText, dayText, dueText, dueUrgency, errorText, nameText, priorityText, taskQuery } from "../lib/tasks.js";
import { ApiError, call, type TaskCard, type TaskListResponse } from "./api";
import { OPEN_TASK, SHOW_ALL_TASKS, TASKS_CHANGED, WORKSPACE_LOADED, type OpenTaskDetail } from "./events";

const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
const SHOWN = 8;

export function PersonalWidget() {
  const [cards, setCards] = useState<TaskCard[]>([]);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const identityRef = useRef(0);
  const loadRef = useRef(0);

  const load = async () => {
    const request = ++loadRef.current;
    const identity = identityRef.current;
    try {
      const response = await call<TaskListResponse>(`/v1/tasks?${taskQuery("personal")}`);
      if (request !== loadRef.current || identity !== identityRef.current) return;
      const items = response.items ?? [];
      setLoaded(true);
      if (!items.length) {
        setCards([]);
        setNote("No open tasks are assigned to you with a due date today or earlier.");
        return;
      }
      const shown = items.slice(0, SHOWN);
      setCards(shown);
      const total = response.page?.total;
      setNote(typeof total === "number" && Number.isFinite(total) && total > shown.length
        ? `Showing ${shown.length} of ${countText(total)} open tasks assigned to you, due by today.`
        : `${countText(total)} open task${total === 1 ? "" : "s"} assigned to you, due by today.`);
    } catch (error) {
      if (request !== loadRef.current || identity !== identityRef.current) return;
      setLoaded(true);
      setCards([]);
      setNote(error instanceof ApiError ? errorText(error.payload) : "Your tasks could not be loaded.");
    }
  };

  useEffect(() => {
    void load();
    const onReload = () => { void load(); };
    const user = document.getElementById("user");
    const onIdentity = () => { identityRef.current += 1; void load(); };
    document.addEventListener(WORKSPACE_LOADED, onReload);
    document.addEventListener(TASKS_CHANGED, onReload);
    user?.addEventListener("change", onIdentity);
    return () => {
      document.removeEventListener(WORKSPACE_LOADED, onReload);
      document.removeEventListener(TASKS_CHANGED, onReload);
      user?.removeEventListener("change", onIdentity);
    };
  }, []);

  const openTask = (card: TaskCard, element: HTMLElement) => {
    document.querySelector<HTMLElement>('[data-view="tasks"]')?.click();
    document.dispatchEvent(new CustomEvent<OpenTaskDetail>(OPEN_TASK, { detail: { id: card.id, element } }));
  };

  const showAll = () => {
    document.dispatchEvent(new CustomEvent(SHOW_ALL_TASKS));
    document.querySelector<HTMLElement>('[data-view="tasks"]')?.click();
  };

  return (
    <section id="personalSection" className="activity-section" aria-labelledby="personalTitle" hidden={!loaded}>
      <div className="section-title"><h2 id="personalTitle">My tasks</h2></div>
      <p id="personalNote" className="muted" role="status">{note}</p>
      <div id="personalList" className="stack" hidden={cards.length === 0}>
        {cards.map(card => <PersonalCard key={card.id} card={card} onOpen={openTask} />)}
      </div>
      <Button type="button" id="personalAll" className="text-button" variant="ghost" hidden={cards.length === 0}
        onPress={showAll}>All tasks</Button>
    </section>
  );
}

function PersonalCard({ card, onOpen }: { card: TaskCard; onOpen: (card: TaskCard, element: HTMLElement) => void }) {
  const element = useRef<HTMLButtonElement | null>(null);
  const urgency = dueUrgency(card.dueDate, today());
  const due = urgency === "overdue" ? `Overdue ${dayText(card.dueDate)}`
    : urgency === "today" ? "Due today"
    : card.dueDate ? `Due ${dayText(card.dueDate)}` : dueText(card.dueDate);
  const priority = card.priority ? `${card.priority} priority` : priorityText(card.priority);
  return (
    <Button type="button" variant="secondary" ref={element} className="activity-item flex h-auto w-full flex-col items-start gap-1 whitespace-normal text-left"
      data-task-id={card.id} onPress={() => { if (element.current) onOpen(card, element.current); }}>
      <span className="item-title">{nameText(card.title)}</span>
      <span className="item-meta">{[card.key ?? "", priority, due].join(" · ")}</span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="status-badge">{nameText(card.status?.name)}</span>
      </span>
    </Button>
  );
}
