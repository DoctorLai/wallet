import { api } from '@steemit/steem-js';
import { call, put, takeEvery } from 'redux-saga/effects';
import * as proposalActions from './ProposalReducer';

const LIST_PROPOSALS = 'fetchDataSaga/LIST_PROPOSALS';
const LIST_VOTED_ON_PROPOSALS = 'fetchDataSaga/LIST_VOTED_ON_PROPOSALS';
// const LIST_VOTER_PROPOSALS = 'fetchDataSaga/LIST_VOTER_PROPOSALS';

export const proposalWatches = [
    takeEvery(LIST_PROPOSALS, listProposalsCaller),
    takeEvery(LIST_VOTED_ON_PROPOSALS, listVotedOnProposalsCaller),
];

export function* listProposalsCaller(action) {
    yield listProposals(action.payload);
}

export function* listVotedOnProposalsCaller(action) {
    yield listVotedOnProposals(action.payload);
}

export function* listProposals({
    voter_id,
    last_proposal,
    order_by,
    order_direction,
    limit,
    status,
    resolve,
    reject,
}) {
    const start = [-1, 0];

    const proposals = yield call(
        [api, api.listProposalsAsync],
        start,
        limit,
        order_by,
        order_direction,
        status
    );

    const proposalIds = proposals.map(p => {
        return p.id;
    });

    let proposalVotesIds = [];

    if (voter_id) {
        let proposalVotes = yield proposalIds.map(function*(pId) {
            let votes = [];
            let nextVotes = [];
            let lastVoter = '';
            let beyondThisProposal = false;
            const maxVotes = 100;
            // ¯\_(ツ)_/¯
            while (true) {
                nextVotes = yield call(
                    [api, api.listProposalVotesAsync],
                    [pId, lastVoter],
                    maxVotes,
                    'by_proposal_voter',
                    'ascending',
                    'all'
                );
                votes = votes.concat(nextVotes);
                lastVoter = nextVotes[nextVotes.length - 1].voter;
                if (nextVotes.length < maxVotes) return votes;
                beyondThisProposal = false;
                nextVotes.map(d => {
                    if (d.proposal.proposal_id != pId)
                        beyondThisProposal = true;
                });
                if (beyondThisProposal) return votes;
            }
        });

        proposalVotes = proposalVotes.reduce((a, b) => a.concat(b), []);

        proposalVotesIds = proposalVotes
            .filter(d => {
                return d.voter == voter_id;
            })
            .map(p => {
                return p.proposal.id;
            });
    }

    // Use hashset to perform O(1) lookups
    const votedSet = new Set(proposalVotesIds);
    const mungedProposals = proposals.map(p => ({
        ...p,
        upVoted: votedSet.has(p.proposal_id)
    }));

    yield put(proposalActions.receiveListProposals({ mungedProposals }));
    if (resolve && mungedProposals) {
        resolve(mungedProposals);
    } else if (reject && !mungedProposals) {
        reject();
    }
}

export function* listVotedOnProposals({
    voter_id,
    limit,
    order_by,
    order_direction,
    status,
    resolve,
    reject,
}) {
    if (!voter_id) {
        reject();
    }
    try {
        const data = yield call(
            [api, api.listProposalVotesAsync],
            [],
            limit,
            'by_voter_proposal',
            order_direction,
            status
        );
        const proposals = data.filter(d => {
            return d.voter == voter_id;
        });
        yield put(
            proposalActions.receiveListProposalVotes({
                proposals,
            })
        );
        if (resolve && proposals) {
            resolve(proposals);
        } else if (reject && !proposals) {
            reject();
        }
    } catch (e) {
        console.error('ProposalSaga->listProposalVotesAsync::error', e);
    }
}

// Action creators
export const actions = {
    listProposals: payload => ({
        type: LIST_PROPOSALS,
        payload,
    }),

    listVotedOnProposals: payload => ({
        type: LIST_VOTED_ON_PROPOSALS,
        payload,
    }),
};
