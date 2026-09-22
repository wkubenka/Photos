import { currentView, onNavigate } from "./urlstate.js";

async function render(): Promise<void> {
  // Filled in by Task 22.
  document.querySelector("#app")!.textContent = JSON.stringify(currentView());
}

onNavigate(() => void render());
void render();
