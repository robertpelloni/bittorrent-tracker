#ifndef MEGATORRENT_CONTROLLER_H
#define MEGATORRENT_CONTROLLER_H

#include "apicontroller.h"

class MegatorrentController : public APIController
{
    Q_OBJECT

public:
    using APIController::APIController;

    Q_INVOKABLE void addSubscriptionAction();
    Q_INVOKABLE void removeSubscriptionAction();
    Q_INVOKABLE void getSubscriptionsAction();
};

#endif // MEGATORRENT_CONTROLLER_H
