// Decides whether an answer from the main process is still wanted. Every request takes a ticket
// naming the folder it was for; an answer is used only when its ticket is the newest one and the
// panel is still showing that folder. A slow answer for the previous folder is therefore dropped
// instead of replacing the current folder's data.

export interface Ticket {
  folder: string
  n: number
}

export class RequestGate {
  private latest = 0

  begin(folder: string): Ticket {
    return { folder, n: ++this.latest }
  }

  isCurrent(ticket: Ticket, activeFolder: string | null): boolean {
    return ticket.n === this.latest && ticket.folder === activeFolder
  }
}
