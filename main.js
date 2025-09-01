import { initRouter } from './src/engine/router.js';
import { showHome, showProfile } from './src/engine/components.js';
import { elSort, elRefresh, elRelax } from './src/ui/render.js';

const router = initRouter({
    onHome: () => {
        document.title = 'FDV.lol';
        showHome();
    },
    onProfile: ({ mint }) => {
        document.title = `${mint.slice(0, 6)}… • FDV.lol`;
        showProfile({ mint });
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