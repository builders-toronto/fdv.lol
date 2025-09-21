import { initRouter } from './src/router/switch.js';
import { showHome, showProfile, showShill } from './src/router/home.js';
import { elSort, elRefresh, elRelax } from './src/views/meme/page.js';
import './src/views/meme/legal.js';

const router = initRouter({
    onHome: () => {
        document.title = 'FDV.lol';
        showHome();
    },
    onProfile: ({ mint }) => {
        document.title = `${mint.slice(0, 6)}… • FDV.lol`;
        showProfile({ mint });
    },
    onShill: ({ mint, leaderboard } = {}) => {
        document.title = leaderboard
          ? `Leaderboard ${mint.slice(0, 6)}… • FDV.lol`
          : `Shill ${mint.slice(0, 6)}… • FDV.lol`;
        showShill({ mint, leaderboard });
    },
    onNotFound: () => {
        document.title = '404 Not Found • FDV.lol';
        showHome();
    }
});

elSort.addEventListener('change', () => showHome());
elRefresh.addEventListener('click', () => showHome({ force: true }));
elRelax.addEventListener('change', () => showHome({ force: true }));

router.dispatch();