import type { ProviderSpec } from './contract'
import { imessage } from '../providers/imessage'

// Every chat service channel knows. Adding one is a folder under providers/
// and a line here.
export const services: readonly ProviderSpec[] = [imessage]
