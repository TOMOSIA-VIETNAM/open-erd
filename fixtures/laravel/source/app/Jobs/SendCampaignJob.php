<?php

namespace App\Jobs;

use App\Mail\CampaignMail;
use App\Models\CampaignRecipient;
use App\Models\Contact;
use App\Models\EmailCampaign;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Support\Facades\Mail;

class SendCampaignJob implements ShouldQueue
{
    use Queueable;

    public function __construct(public EmailCampaign $campaign)
    {
    }

    public function handle(): void
    {
        $this->campaign->recipients()->whereNull('sent_at')->each(function (CampaignRecipient $recipient) {
            $contact = Contact::find($recipient->contact_id);
            if (! $contact || ! $contact->email) {
                return;
            }
            Mail::to($contact->email)->send(new CampaignMail($this->campaign, $contact));
            $recipient->update(['sent_at' => now()]);
        });
    }
}
