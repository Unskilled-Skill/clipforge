import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import { Modal } from "./panels";
import { filterCommands } from "./studio-data";

export interface StudioCommand {
  id: string; label: string; detail?: string; keywords?: string; shortcut?: string;
  group: "Actions" | "Views" | "Games" | "Clips"; run: () => void;
}

export function StudioCommands({ items, onClose }: { items: StudioCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const results = filterCommands(items, query).slice(0, 40);
  const activeIndex = Math.min(index, Math.max(0, results.length - 1));
  const activeId = results.length ? `${listId}-${activeIndex}` : undefined;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { document.getElementById(activeId ?? "")?.scrollIntoView({ block: "nearest" }); }, [activeId, query]);
  const run = (item: StudioCommand) => { onClose(); item.run(); };
  return <Modal label="Search clips and commands" className="st-command" onClose={onClose} zIndex={240}>
    <div className="st-command-search">
      <MagnifyingGlass size={18} />
      <input aria-label="Search clips and commands" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} autoComplete="off" placeholder="Type a game, clip name or command"
        value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }}
        onKeyDown={e => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            if (!results.length) return;
            setIndex(e.key === "Home" ? 0 : e.key === "End" ? results.length - 1 : (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
          } else if (e.key === "Enter" && results[activeIndex]) { e.preventDefault(); run(results[activeIndex]); }
        }} />
      <button className="st-ghost" onClick={onClose} aria-label="Close commands">Esc</button>
    </div>
    <div className="st-command-list" id={listId} role="listbox" aria-label="Commands and clips" ref={list}>
      {results.length === 0 && <p className="st-command-empty">No matching clips or commands. Try a game name, “export” or “settings”.</p>}
      {results.map((item, i) => <div key={item.id}>
        {(i === 0 || results[i - 1].group !== item.group) && <div className="st-command-group">{item.group}</div>}
        <button id={`${listId}-${i}`} role="option" aria-selected={i === activeIndex} tabIndex={-1} className={`st-command-result ${i === activeIndex ? "active" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => run(item)}>
          <ArrowRight size={15} /><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      </div>)}
    </div>
    <footer><span><kbd>↑↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span>Search is local to your library</span></footer>
  </Modal>;
}
