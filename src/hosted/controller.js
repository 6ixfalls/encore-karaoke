// EnMoku presentation for the hosted room protocol.
export function mountController() {
  const $ = id => document.getElementById(id);
  const room = $("room");
  room.dataset.view = window.matchMedia("(max-width: 767px)").matches ? "remote" : "songs";
  const navigation = document.createElement("nav");
  navigation.className = "controller-nav";
  navigation.setAttribute("aria-label", "Controller views");
  const remote = document.createElement("section");
  remote.className = "remote-panel"; remote.id = "controller-remote";
  const title = document.createElement("h2");
  title.className = "remote-title-desktop"; title.textContent = "ENCORE";
  remote.append(title, document.querySelector(".stage"), $("remote-microphone"));
  const columns = document.querySelector("#room > .columns");
  const songs = columns.children[0], queue = columns.children[1];
  songs.id = "controller-songs"; queue.id = "controller-queue";
  songs.classList.add("library-panel"); queue.classList.add("library-panel");
  const library = document.createElement("div"); library.className = "controller-library";
  for (const [view, text] of [["remote", "Remote"], ["songs", "Song search"], ["queue", "Reservations"]]) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = text; button.dataset.view = view;
    button.setAttribute("aria-controls", `controller-${view}`);
    const select = () => {
      room.dataset.view = view;
      for (const item of navigation.children) item.setAttribute("aria-pressed", String(item === button));
    };
    button.addEventListener("click", select);
    button.setAttribute("aria-pressed", String(view === room.dataset.view));
    navigation.append(button);
  }
  library.append(navigation, songs, queue);
  columns.remove();
  const layout = document.createElement("div"); layout.className = "controller-layout";
  layout.append(remote, library); room.append(layout);
  $("play").textContent = "▶  PLAY";
  $("pause").textContent = "Ⅱ  PAUSE";
  $("skip").textContent = "SKIP  ▷|";
}
