import company from './company.js';
import { createSemanticPlanner } from '../../packages/models/src/planner.js';
export default { ...company, planners: [createSemanticPlanner()] };
