/** The one Vercel Function. vercel.json sends every /api/* path here. */
import { handle } from '../server/app.js';

export default { fetch: handle };
