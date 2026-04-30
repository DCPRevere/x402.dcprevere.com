export interface ParsedBoardPost {
  author: string;
  body: string;
}

export interface ParsedAuctionCreate {
  seller: string;
  description: string;
  min_bid_usdc: string;
  bid_deadline: string;
  reveal_deadline: string;
}

export interface ParsedAuctionBid {
  auctionId: string;
  bidder: string;
  commitment: string;
}

export interface ParsedBarSay {
  speaker: string;
  line: string;
}
