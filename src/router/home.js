import { pipeline } from '../engine/pipeline.js';
import { renderProfileView } from "../views/profile/page.js";
import { render } from '../views/meme/page.js';
import { hideLoading } from '../utils/tools.js';

export async function showHome({ force = false } = {}) {
  try {
    const pipe = await pipeline({
      force,
      stream: true,
      onUpdate: ({ items, ad }) => {
        render(items, ad);         
      }
    });
    render(pipe.items, pipe.ad);     
  } finally {
    hideLoading();
  }
}

export async function showProfile({ mint }) {
  try {
    renderProfileView(mint);
  } finally {
    hideLoading();
  }
}
