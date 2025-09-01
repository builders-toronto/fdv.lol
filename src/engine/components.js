import { pipeline } from './pipeline.js';
import { renderProfileView } from '../ui/profile.js';
import { render } from '../ui/render.js';
import { showLoading, hideLoading } from '../utils/tools.js';

export async function showHome({ force = false } = {}) {
    const pipe = await pipeline( { force });
    render(pipe.items, pipe.ad);
}

export async function showProfile({ mint }) {
    showLoading();
    try {
        renderProfileView(mint);
    } finally {
        hideLoading();
    }
}
