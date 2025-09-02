import { pipeline } from './pipeline.js';
import { renderProfileView } from '../ui/profile.js';
import { render } from '../ui/render.js';
import { hideLoading } from '../utils/tools.js';

// export async function showHome({ force = false } = {}) {
//   try {
//     const pipe = await pipeline({
//       force,
//       stream: true,
//       onUpdate: (scored) => {
//         render(scored, CURRENT_AD);
//       }
//     });
//     render(pipe.items, pipe.ad); // final render at end
//   } finally {
//     hideLoading();
//   }
// }

export async function showHome({ force = false } = {}) {
    try {
        const pipe = await pipeline( { force });
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
