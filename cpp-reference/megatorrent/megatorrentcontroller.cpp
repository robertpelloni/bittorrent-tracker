#include "megatorrentcontroller.h"

#include "base/bittorrent/session.h"

void MegatorrentController::addSubscriptionAction()
{
    requireParams({u"publicKey"_s, u"label"_s});

    const QString publicKey = params()[u"publicKey"_s];
    const QString label = params()[u"label"_s];

    if (!BitTorrent::Session::instance()->addMegatorrentSubscription(publicKey, label))
        throw APIError(APIErrorType::GenericError, tr("Failed to add subscription. Invalid key or subscription already exists."));
}

void MegatorrentController::removeSubscriptionAction()
{
    requireParams({u"publicKey"_s});

    const QString publicKey = params()[u"publicKey"_s];

    if (!BitTorrent::Session::instance()->removeMegatorrentSubscription(publicKey))
        throw APIError(APIErrorType::GenericError, tr("Failed to remove subscription."));
}

void MegatorrentController::getSubscriptionsAction()
{
    setResult(BitTorrent::Session::instance()->getMegatorrentSubscriptions());
}
