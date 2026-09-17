export type PlaybackStatus = "loading" | "paused" | "playing" | "seeking" | "at-live-head" | "ended" | "error";

export interface PlaybackState {
  status: PlaybackStatus;
  cursor: number;
  head: number;
  speed: number;
  error: string | null;
}

export type PlaybackAction =
  | { type: "loaded"; head: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek-start" }
  | { type: "seek-complete"; cursor: number; head: number; live: boolean }
  | { type: "cursor"; cursor: number; head: number }
  | { type: "speed"; speed: number }
  | { type: "error"; message: string }
  | { type: "head"; head: number };

export const initialPlaybackState: PlaybackState = { status: "loading", cursor: -1, head: -1, speed: 1, error: null };

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  if (action.type === "error") return { ...state, status: "error", error: action.message };
  switch (action.type) {
    case "loaded":
      return { ...state, status: action.head < 0 ? "ended" : "paused", cursor: -1, head: action.head, error: null };
    case "play":
      if (state.status === "error" || state.status === "loading" || state.status === "seeking" || state.status === "ended") return state;
      return { ...state, status: "playing" };
    case "pause":
      if (state.status !== "playing" && state.status !== "at-live-head") return state;
      return { ...state, status: "paused" };
    case "seek-start":
      if (state.status === "error") return state;
      return { ...state, status: "seeking" };
    case "seek-complete":
      return { ...state, status: action.cursor === action.head && action.live ? "at-live-head" : "paused", cursor: action.cursor, head: action.head, error: null };
    case "cursor":
      return { ...state, cursor: action.cursor, head: action.head };
    case "speed":
      return { ...state, speed: action.speed };
    case "head":
      return { ...state, head: action.head };
  }
}
